#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "This script must be run from within a git repository"
    exit 1
fi

# Check if there are uncommitted changes
if ! git diff-index --quiet HEAD --; then
    print_warning "You have uncommitted changes. Please commit them first:"
    echo
    git status --porcelain
    echo
    read -p "Do you want to commit these changes now? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Please enter a commit message:"
        read -r commit_message
        if [ -z "$commit_message" ]; then
            print_error "Commit message cannot be empty"
            exit 1
        fi
        git add .
        git commit -m "$commit_message"
        print_success "Changes committed"
    else
        print_error "Please commit your changes before building"
        exit 1
    fi
fi

# Get the short commit hash
COMMIT_HASH=$(git rev-parse --short HEAD)
IMAGE_TAG="quicklookup/synmetrix-actions:$COMMIT_HASH"

print_status "Building and pushing Docker image..."
print_status "Image tag: $IMAGE_TAG"

# Build and push the Docker image
if docker build --platform linux/amd64 -t "$IMAGE_TAG" . --push; then
    print_success "Docker image built and pushed successfully!"
    print_success "Image: $IMAGE_TAG"
    
    # Also tag as latest if we're on main/master branch
    CURRENT_BRANCH=$(git branch --show-current)
    if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
        LATEST_TAG="quicklookup/synmetrix-actions:latest"
        print_status "Tagging as latest since we're on $CURRENT_BRANCH branch..."
        if docker tag "$IMAGE_TAG" "$LATEST_TAG" && docker push "$LATEST_TAG"; then
            print_success "Also tagged and pushed as: $LATEST_TAG"
        else
            print_warning "Failed to tag/push as latest, but main image was successful"
        fi
    fi
else
    print_error "Failed to build and push Docker image"
    exit 1
fi

print_success "Build process completed!"

