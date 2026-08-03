#!/bin/bash
set -e
cd "Canvas Display Hermes"
tar czf - -C core src test package.json tsconfig.json Dockerfile docker-compose.yml