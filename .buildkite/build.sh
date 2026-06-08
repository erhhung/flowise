set -euo pipefail

buildah_login

image="$IMAGE_NAME"
buildah_build $image --no-cache -f ./Dockerfile .
buildah_push  $image $GIT_COMMIT_SHORT_SHA

image="${IMAGE_NAME}-worker"
buildah_build $image -f ./docker/worker/Dockerfile .
buildah_push  $image $GIT_COMMIT_SHORT_SHA
