# Publishing Guide for Scratchbox IDE

This document provides a guide for building, packaging, and releasing new versions of Scratchbox IDE.

## Building and Packaging

### 1. Install Dependencies
```sh
yarn
```

### 2. Build Extensions & Applications
```sh
yarn build
```

### 3. Package Electron Application
```sh
yarn package:applications
```
The packaged binaries will be located under `applications/electron/dist/`.

### 4. Build Docker Container
```sh
docker build -t scratchbox-ide -f browser.Dockerfile .
```
