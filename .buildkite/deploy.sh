set -euo pipefail

component="$IMAGE_NAME"
image="$CI_REGISTRY_PATH/$component:$GIT_COMMIT_SHORT_SHA"
set_k8s_image Deployment $NAMESPACE $component initContainer update-ca-bundle $image
set_k8s_image Deployment $NAMESPACE $component container flowise $image
kubectl rollout restart Deployment -n $NAMESPACE $component

component="${IMAGE_NAME}-worker"
image="$CI_REGISTRY_PATH/$component:$GIT_COMMIT_SHORT_SHA"
set_k8s_image Deployment $NAMESPACE $component initContainer update-ca-bundle $image
set_k8s_image Deployment $NAMESPACE $component container worker $image
kubectl rollout restart Deployment -n $NAMESPACE $component
