FROM node:14.16.0-buster-slim

RUN mkdir -p /app
RUN mkdir -p /npm_cache

WORKDIR /app

RUN npm install npm@^6 -g
RUN npm config set cache /npm_cache
RUN npm config set prefer-offline true

COPY package.json package-lock.json scripts/filter-package-json-cli.js scripts/filter-package-lock-json-cli.js /app/
# Remove the local dependencies(`file:` entries) from package.json and package-lock.json
RUN cat package.json | node filter-package-json-cli.js > temp-package.json && cat temp-package.json > package.json && rm temp-package.json
RUN cat package-lock.json | node filter-package-lock-json-cli.js > temp-package-lock.json && cat temp-package-lock.json > package-lock.json && rm temp-package-lock.json

# git is required to fetch some NPM packages,
# ca-certificates for various requests over https
# make is required for some steps of the pipeline (see .gitlab-ci.yml and Makefile)
# we add (and then remove) the dependencies to install node-gyp
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git make python g++ \
    # Normally we use `npm install --production` but we need the
    # devDependencies(like webpack) installed so we can run in NODE_ENV=test-docker
    && npm install
# We keep the python and g++ around so we can re-install everything later in CI if necessary

RUN rm -rf /tmp/* /var/cache/apk/* /root/.npm /root/.node-gyp /root/.gnupg /root/.ssh 2>/dev/null
