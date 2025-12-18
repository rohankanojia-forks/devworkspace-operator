import http from 'k6/http';
import {check, sleep} from 'k6';
import exec from 'k6/execution';
import {SharedArray} from 'k6/data';
import {Counter, Rate, Trend} from 'k6/metrics';
import {textSummary} from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

export const execAllowed = new Counter('exec_allowed_total');
export const execDenied = new Counter('exec_denied_total');
export const execUnexpectedAllowed = new Counter('exec_unexpected_allowed_total');
export const execUnexpectedDenied = new Counter('exec_unexpected_denied_total');
export const execAllowRate = new Rate('exec_allow_rate');
export const execDenyRate = new Rate('exec_deny_rate');
export const execLatency = new Trend('exec_latency_ms');
export const createLatency = new Trend('create_latency_ms');
export const invalidMutatingDeny = new Counter('invalid_mutating_deny_ms');
export const mutatingWebhookLatency = new Trend('mutating_latency_ms');

// Users loaded from JSON
const users = new SharedArray('users', () => JSON.parse(open('./sa-tokens.json')));

const TEST_NAMESPACE = __ENV.LOAD_TEST_NAMESPACE || 'dw-webhook-loadtest';
const K8S_API = __ENV.KUBE_API || 'https://api.crc.testing:6443/';
const DW_API_PATH = `/apis/workspace.devfile.io/v1alpha2/namespaces/${TEST_NAMESPACE}/devworkspaces`;

const devWorkspaceReadyTimeout = Number(__ENV.DEV_WORKSPACE_READY_TIMEOUT_IN_SECONDS || 120);

export const options = {
    vus: users.length,
    iterations: users.length,
    insecureSkipTLSVerify: true,
};

// ---------------- Main test ----------------
export default function () {
    const user = users[exec.vu.idInTest - 1];
    const headers = {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
    };

    // -------- PHASE 1: Create DevWorkspace --------
    const dwName = createDevWorkspace(user, headers);
    if (!dwName) return;

    // -------- PHASE 2: Wait until all DevWorkspaces are ready --------
    if (!waitUntilAllDevWorkspacesAreRunning(TEST_NAMESPACE, headers, users.length)) {
        console.error('[ERROR] Not all DevWorkspaces became Ready/Running');
        return;
    }

    // -------- PHASE 3: Validate identity immutability --------
    validateDevWorkspaceAndRelatedResourcesImmutability(user, headers, dwName);

    // -------- PHASE 4: Exec checks --------
    const allDwNames = getAllDevWorkspaceNames(TEST_NAMESPACE, headers);
    for (const name of allDwNames) {
        const isOwn = name === dwName;

        checkExecPermission(
            headers,
            user.user,
            TEST_NAMESPACE,
            name,
            isOwn // own DW → allow, others → forbid
        );
    }
}

export function handleSummary(data) {
    const keep = [
        'exec_allow_rate',
        'exec_deny_rate',
        'create_latency_ms',
        'exec_latency_ms',
        'mutating_latency_ms',
        'invalid_mutating_deny_ms',
        'exec_allowed_total',
        'exec_denied_total',
        'exec_unexpected_allowed_total',
        'exec_unexpected_denied_total',
    ];

    for (const k of Object.keys(data.metrics)) {
        if (!keep.includes(k)) {
            delete data.metrics[k];
        }
    }
    return {
        stdout: textSummary(data, {indent: ' ', enableColors: true})
    }
}

// ---------------- Generic helpers ----------------
function createDevWorkspace(user, headers) {
    const dwPayload = {
        apiVersion: 'workspace.devfile.io/v1alpha2',
        kind: 'DevWorkspace',
        metadata: {
            generateName: `dw-${user.user}-`,
            namespace: TEST_NAMESPACE,
            annotations: { 'controller.devfile.io/restricted-access': 'true' },
            labels: { 'console.openshift.io/terminal': 'true' },
        },
        spec: {
            started: true,
            routingClass: 'web-terminal',
            template: {
                components: [
                    {
                        name: 'restricted-access-container',
                        container: {
                            image: 'quay.io/wto/web-terminal-tooling:latest',
                            mountSources: false,
                            args: ['tail', '-f', '/dev/null'],
                        },
                    },
                ],
            },
        },
    };

    const startTime = Date.now();
    const res = http.post(
        `${K8S_API}${DW_API_PATH}`,
        JSON.stringify(dwPayload),
        { headers, timeout: '60s' }
    );

    createLatency.add(Date.now() - startTime);

    if (res.status !== 201) {
        console.error(`[ERROR] DevWorkspace creation failed for ${user.user}: ${res.status}`);
        return null;
    }

    return res.json()?.metadata?.name ?? null;
}

function validateDevWorkspaceAndRelatedResourcesImmutability(user, headers, dwName) {
    validateDevWorkspaceIdentityImmutability(headers, dwName);
    validateDevWorkspacePodIdentityImmutability(headers, dwName);
}

function validateDevWorkspaceIdentityImmutability(headers, dwName) {
    const forbiddenPatch = [
        {
            op: 'replace',
            path: '/metadata/labels/controller.devfile.io~1devworkspace_id',
            value: `invalid-${Date.now()}`,
        },
        {
            op: 'replace',
            path: '/metadata/labels/controller.devfile.io~1creator',
            value: `00000000-0000-0000-0000-000000000000`,
        },
    ];

    const patchHeaders = {
        ...headers,
        'Content-Type': 'application/json-patch+json',
    };

    const mutateDevWorkspaceStartTime = Date.now();
    const res = http.patch(
        `${K8S_API}${DW_API_PATH}/${dwName}`,
        JSON.stringify(forbiddenPatch),
        { headers: patchHeaders, timeout: '30s' }
    );
    mutatingWebhookLatency.add(Date.now() - mutateDevWorkspaceStartTime);
    assertForbidden(res, 'DevWorkspace', dwName, "admission webhook \"mutate.devworkspace-controller.svc\" denied the request:" +
        " label 'controller.devfile.io/creator' is assigned once devworkspace is created and is immutable");
}

function validateDevWorkspacePodIdentityImmutability(headers, dwName) {
    const forbiddenPatch = [
        {
            op: 'replace',
            path: '/metadata/labels/controller.devfile.io~1devworkspace_id',
            value: `invalid-${Date.now()}`,
        },
        {
            op: 'replace',
            path: '/metadata/labels/controller.devfile.io~1creator',
            value: `00000000-0000-0000-0000-000000000000`,
        },
    ];

    const patchHeaders = {
        ...headers,
        'Content-Type': 'application/json-patch+json',
    };

    let podName = getPodNameForDevWorkspace(headers, TEST_NAMESPACE, dwName);
    let validatePodIdentityImmutability = Date.now();
    const res = http.patch(
        `${K8S_API}/api/v1/namespaces/${TEST_NAMESPACE}/pods/${podName}`,
        JSON.stringify(forbiddenPatch),
        { headers: patchHeaders, timeout: '30s' }
    );
    mutatingWebhookLatency.add(Date.now() - validatePodIdentityImmutability);

    assertForbidden(res, 'Pod', podName, "admission webhook \"mutate-ws-resources.devworkspace-controller.svc\" denied the request: " +
        "Label 'controller.devfile.io/creator' is set by the controller and cannot be updated");
}

function waitUntilAllDevWorkspacesAreRunning(namespace, headers, expectedCount) {
    const dwUrl = `${K8S_API}/apis/workspace.devfile.io/v1alpha2/namespaces/${namespace}/devworkspaces`;
    const pollInterval = 5; // seconds
    const maxAttempts = devWorkspaceReadyTimeout / pollInterval;
    let attempts = 0;

    while (attempts < maxAttempts) {
        const res = http.get(dwUrl, { headers, timeout: '10s' });
        if (res.status === 200) {
            try {
                const items = JSON.parse(res.body)?.items || [];
                const runningCount = items.filter(dw => dw.status?.phase === 'Running' || dw.status?.phase === 'Ready').length;

                if (runningCount >= expectedCount) return true; // all ready
            } catch (e) {
                console.error(`[ERROR] Failed to parse DevWorkspaces: ${e.message}`);
            }
        } else {
            console.error(`[ERROR] GET DevWorkspaces returned status ${res.status}`);
        }

        sleep(pollInterval);
        attempts++;
    }

    console.error('[ERROR] Timeout waiting for all DevWorkspaces to become Ready/Running');
    return false;
}

function checkExecPermission(headers, userName, namespace, dwName, shouldAllow = true) {
    const podName = getPodNameForDevWorkspace(headers, namespace, dwName);

    // Attempt exec
    const execStartTime = Date.now();
    const execUrl = `${K8S_API}/api/v1/namespaces/${namespace}/pods/${podName}/exec?command=echo&command=hello`;

    const res = http.post(execUrl, null, { headers, timeout: '30s' });
    execLatency.add(Date.now() - execStartTime);

    const allowed = res.status !== 403;
    if (shouldAllow) {
        execAllowRate.add(allowed);
        if (allowed) {
            execAllowed.add(1);
        } else {
            execUnexpectedDenied.add(1);
            console.error(`[SECURITY] Own exec denied for ${dwName} for user ${userName}`);
        }
    } else {
        execDenyRate.add(!allowed);
        if (!allowed) {
            execDenied.add(1);
        } else {
            execUnexpectedAllowed.add(1);
            console.error(`[SECURITY] Cross-user exec ALLOWED for ${dwName} for user ${userName}`);
        }
    }

    const checkName = shouldAllow
        ? 'exec allowed for own workspace'
        : 'exec forbidden for foreign workspace';

    const checkFn = () => shouldAllow ? allowed : !allowed;

    check(res, {
        [checkName]: checkFn,
    });

    return res.status;
}

function getAllDevWorkspaceNames(namespace, headers) {
    const url = `${K8S_API}/apis/workspace.devfile.io/v1alpha2/namespaces/${namespace}/devworkspaces`;

    const res = http.get(url, { headers, timeout: '30s' });
    if (res.status !== 200) {
        console.error(`[ERROR] Failed to list DevWorkspaces: status=${res.status}, body=${res.body}`);
        return [];
    }

    let items = [];
    try {
        items = res.json()?.items || [];
    } catch (e) {
        console.error(`[ERROR] Failed to parse DevWorkspace list: ${e.message}`);
        return [];
    }

    return items.map(dw => dw.metadata?.name).filter(Boolean);
}

function assertForbidden(res, resourceKind, resourceName, expectedMessage) {
    const body = res.json?.();

    const statusOk = res.status === 403;
    const reasonOk = body?.reason === 'Forbidden';
    const messageOk =
        body?.message?.includes(expectedMessage);

    if (!statusOk || !reasonOk || !messageOk) {
        console.error(
            `[ERROR] Unauthorized ${resourceKind} modification allowed
resource=${resourceName}
status=${res.status}
reason=${body?.reason}
message=${body?.message}`
        );
    }
    invalidMutatingDeny.add(1);
}

/**
 * Get the first pod name for a given DevWorkspace
 * @param {Object} headers - HTTP headers
 * @param {string} namespace - Kubernetes namespace
 * @param {string} dwName - DevWorkspace name
 * @returns {string|null} - Pod name or null if not found
 */
function getPodNameForDevWorkspace(headers, namespace, dwName) {
    const podListUrl = `${K8S_API}/api/v1/namespaces/${namespace}/pods?labelSelector=controller.devfile.io/devworkspace_name=${dwName}`;
    const podListRes = http.get(podListUrl, { headers, timeout: '30s' });
    const pods = podListRes.json()?.items || [];

    if (!pods.length) {
        console.warn(`[WARN] No pods found for DevWorkspace ${dwName}`);
        return null;
    }

    return pods[0].metadata.name;
}
