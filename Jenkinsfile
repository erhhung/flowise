// groovylint-disable CompileStatic
// groovylint-disable NestedBlockDepth
// groovylint-disable DuplicateStringLiteral
// groovylint-disable GStringExpressionWithinString

// global shared library functions: defaultCheckout, withHarbor, bash
// https://github.com/erhhung/homelab-k8s/tree/main/files/jenkins/sharedlib

pipeline {
  agent { label 'builder' }

  options {
    skipDefaultCheckout()
  }
  environment {
    IMAGE_NAME = 'flowise'
    NAMESPACE  = 'flowise'
  }

  stages {
    stage('Setup') {
      steps {
        defaultCheckout()

        // inject Harbor credential
        // vars for `buildah_login`
        withHarbor {
          bash '''
          sys_info
          env_vars
          identities
          init_certs
          buildah_login
          '''
        }
      }
    }

    stage('Build') {
      steps {
        bash '''
        image="$IMAGE_NAME"
        # `buildah_*` functions will emit section markers
        buildah_build $image --no-cache -f ./Dockerfile .
        buildah_push  $image $GIT_COMMIT_SHORT_SHA

        image="${IMAGE_NAME}-worker"
        buildah_build $image --no-cache -f ./docker/worker/Dockerfile .
        buildah_push  $image $GIT_COMMIT_SHORT_SHA
        '''
      }
    }

    stage('Deploy') {
      steps {
        bash '''
        component="$IMAGE_NAME"
        image="$CI_REGISTRY_PATH/$component:$GIT_COMMIT_SHORT_SHA"
        section_start deploy "Deploy $component"
        set_k8s_image Deployment $NAMESPACE $component initContainer update-ca-bundle $image
        set_k8s_image Deployment $NAMESPACE $component container flowise $image
        kubectl rollout restart Deployment -n $NAMESPACE $component
        section_end deploy

        component="${IMAGE_NAME}-worker"
        image="$CI_REGISTRY_PATH/$component:$GIT_COMMIT_SHORT_SHA"
        section_start deploy "Deploy $component"
        set_k8s_image Deployment $NAMESPACE $component initContainer update-ca-bundle $image
        set_k8s_image Deployment $NAMESPACE $component container worker $image
        kubectl rollout restart Deployment -n $NAMESPACE $component
        section_end deploy
        '''
      }
    }
  }
}
