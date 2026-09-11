# Builder stage
FROM node:22-bullseye AS build-stage

# install required tools to build the application
RUN apt-get update && apt-get install -y libxkbfile-dev libsecret-1-dev

WORKDIR /home/scratchbox

# Copy repository files
COPY . .

# Remove unnecesarry files for the browser application
# Download plugins and build application production mode
# Use yarn autoclean to remove unnecessary files from package dependencies
RUN yarn config set network-timeout 600000 -g && \
    yarn --pure-lockfile && \
    yarn build:extensions && \
    yarn download:plugins && \
    yarn browser build && \
    yarn && \
    yarn autoclean --init && \
    echo *.ts >> .yarnclean && \
    echo *.ts.map >> .yarnclean && \
    echo *.spec.* >> .yarnclean && \
    yarn autoclean --force && \
    yarn cache clean && \
    rm -rf .git applications/electron extensions/launcher extensions/updater node_modules

# Production stage uses a small base image
FROM node:22-bullseye-slim AS production-stage

# Create scratchbox user and directories
# Application will be copied to /home/scratchbox
# Default workspace is located at /home/project
RUN adduser --system --group scratchbox
RUN chmod g+rw /home && \
    mkdir -p /home/project && \
    chown -R scratchbox:scratchbox /home/scratchbox && \
    chown -R scratchbox:scratchbox /home/project;

# Install required tools for application: Temurin JDK, JDK, SSH, Bash, Maven
# Node is already available in base image
RUN apt-get update && apt-get install -y wget apt-transport-https && \
    apt-get update && apt-get install -y git openssh-client openssh-server bash libsecret-1-0 openjdk-17-jdk maven && \
    apt-get purge -y wget && \
    apt-get clean

ENV HOME /home/scratchbox
WORKDIR /home/scratchbox

# Copy application from builder-stage
COPY --from=build-stage --chown=scratchbox:scratchbox /home/scratchbox /home/scratchbox

EXPOSE 3000

# Specify default shell for Theia/Scratchbox and the Built-In plugins directory
ENV SHELL=/bin/bash \
    SCRATCHBOX_DEFAULT_PLUGINS=local-dir:/home/scratchbox/plugins \
    THEIA_DEFAULT_PLUGINS=local-dir:/home/scratchbox/plugins

# Use installed git instead of dugite
ENV USE_LOCAL_GIT true

# Switch to scratchbox user
USER scratchbox
WORKDIR /home/scratchbox/applications/browser

# Launch the backend application via node
ENTRYPOINT [ "node", "/home/scratchbox/applications/browser/lib/backend/main.js" ]

# Arguments passed to the application
CMD [ "/home/project", "--hostname=0.0.0.0" ]
