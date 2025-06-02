// Copyright (c) 2019-2025 Red Hat, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package workspace

import (
	"github.com/stretchr/testify/assert"
	admregv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"testing"
)

func TestBuildValidatingWebhookCfg(t *testing.T) {
	// Given
	testNamespace := "test-namespace"
	// When
	validatingWebhookCfg := buildValidatingWebhookCfg(testNamespace)
	// Then
	assert.NotNil(t, validatingWebhookCfg)
	assert.Equal(t, "controller.devfile.io", validatingWebhookCfg.ObjectMeta.Name)
	assert.Equal(t, map[string]string{
		"app.kubernetes.io/name":    "devworkspace-webhook-server",
		"app.kubernetes.io/part-of": "devworkspace-operator",
	}, validatingWebhookCfg.ObjectMeta.Labels)
	assert.Len(t, validatingWebhookCfg.Webhooks, 2)
	webhook1 := validatingWebhookCfg.Webhooks[0]
	assert.Equal(t, "validate-exec.devworkspace-controller.svc", webhook1.Name)
	assert.NotNil(t, webhook1.FailurePolicy)
	assert.Equal(t, admregv1.Fail, *webhook1.FailurePolicy)
	assert.NotNil(t, webhook1.ClientConfig.Service)
	assert.Equal(t, "devworkspace-webhookserver", webhook1.ClientConfig.Service.Name)
	assert.Equal(t, testNamespace, webhook1.ClientConfig.Service.Namespace)
	assert.NotNil(t, webhook1.ObjectSelector)
	assert.Len(t, webhook1.ObjectSelector.MatchExpressions, 1)
	assert.Equal(t, "controller.devfile.io/create", webhook1.ObjectSelector.MatchExpressions[0].Key)
	assert.Equal(t, metav1.LabelSelectorOpExists, webhook1.ObjectSelector.MatchExpressions[0].Operator)
	assert.Len(t, webhook1.Rules, 1)
	assert.Equal(t, []admregv1.OperationType{admregv1.Connect}, webhook1.Rules[0].Operations)
	assert.Equal(t, admregv1.Rule{
		APIGroups:   []string{""},
		APIVersions: []string{"v1"},
		Resources:   []string{"pods/exec"},
	}, webhook1.Rules[0].Rule)
	assert.Equal(t, []string{"v1beta1", "v1"}, webhook1.AdmissionReviewVersions)

	// Verify second webhook
	webhook2 := validatingWebhookCfg.Webhooks[1]
	assert.Equal(t, "validate-devfile.devworkspace-controller.svc", webhook2.Name)
	assert.NotNil(t, webhook2.ObjectSelector)
	assert.Len(t, webhook2.ObjectSelector.MatchExpressions, 1)
	assert.Equal(t, "controller.devfile.io/create", webhook2.ObjectSelector.MatchExpressions[0].Key)
	assert.NotNil(t, webhook2.ClientConfig.Service)
	assert.Equal(t, "devworkspace-webhookserver", webhook2.ClientConfig.Service.Name)
	assert.Equal(t, testNamespace, webhook2.ClientConfig.Service.Namespace)
	assert.Len(t, webhook2.Rules, 1)
	assert.Equal(t, []admregv1.OperationType{admregv1.Create, admregv1.Update}, webhook2.Rules[0].Operations)
	assert.Equal(t, admregv1.Rule{
		APIGroups:   []string{"workspace.devfile.io"},
		APIVersions: []string{"v1alpha2"},
		Resources:   []string{"devworkspaces"},
	}, webhook2.Rules[0].Rule)
	assert.Equal(t, []string{"v1beta1", "v1"}, webhook2.AdmissionReviewVersions)
}
