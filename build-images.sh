#!/bin/bash
DOCKER_DEFAULT_PLATFORM=linux/arm64 docker compose build
docker save $(docker compose config --images) | gzip > app-images.tar.gz
#scp app-images.tar.gz user@weak-ip:/home/user/app/
