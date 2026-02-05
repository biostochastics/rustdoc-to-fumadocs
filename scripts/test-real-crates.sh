#!/bin/bash
# Test rustdoc-to-fumadocs against real public crates
# Usage: ./scripts/test-real-crates.sh [crate1] [crate2] ...
# Default: tests against serde, tokio, and anyhow

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_DIR="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$TOOL_DIR/test-output"
FIXTURES_DIR="$TOOL_DIR/tests/fixtures/real-crates"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default crates to test if none specified
DEFAULT_CRATES=(
    "serde"
    "anyhow"
    "thiserror"
)

# Parse arguments
CRATES=("${@:-${DEFAULT_CRATES[@]}}")

echo "========================================"
echo "rustdoc-to-fumadocs Real Crate Testing"
echo "========================================"
echo ""

# Check for required tools
check_tool() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}Error: $1 is required but not installed.${NC}"
        exit 1
    fi
}

check_tool cargo
check_tool rustup
check_tool npm

# Ensure nightly is available
if ! rustup run nightly rustc --version &> /dev/null; then
    echo -e "${YELLOW}Installing Rust nightly toolchain...${NC}"
    rustup install nightly
fi

# Create directories
mkdir -p "$TEST_DIR"
mkdir -p "$FIXTURES_DIR"

# Build the tool
echo -e "${YELLOW}Building rustdoc-to-fumadocs...${NC}"
cd "$TOOL_DIR"
npm install --silent
npm run build --silent 2>/dev/null || true

# Function to test a single crate
test_crate() {
    local crate="$1"
    local crate_dir="$TEST_DIR/$crate"
    local json_file="$FIXTURES_DIR/${crate}.json"
    local output_dir="$TEST_DIR/${crate}-docs"

    echo ""
    echo "----------------------------------------"
    echo "Testing crate: $crate"
    echo "----------------------------------------"

    # Check if we have cached JSON
    if [ -f "$json_file" ]; then
        echo -e "${GREEN}Using cached rustdoc JSON${NC}"
    else
        echo -e "${YELLOW}Generating rustdoc JSON for $crate...${NC}"

        # Create temp cargo project
        rm -rf "$crate_dir"
        mkdir -p "$crate_dir"
        cd "$crate_dir"

        # Initialize cargo project with the crate as dependency
        cargo init --name "test_${crate}" --quiet

        # Add the crate as a dependency
        cargo add "$crate" --quiet 2>/dev/null || {
            echo -e "${RED}Failed to add crate $crate${NC}"
            return 1
        }

        # Generate rustdoc JSON
        RUSTDOCFLAGS="-Z unstable-options --output-format json" \
            cargo +nightly doc --no-deps --quiet 2>/dev/null || {
            echo -e "${RED}Failed to generate rustdoc JSON for $crate${NC}"
            return 1
        }

        # Find the JSON file (handle crate name with hyphens -> underscores)
        local crate_underscore="${crate//-/_}"
        local found_json=""

        for potential in "target/doc/${crate}.json" "target/doc/${crate_underscore}.json"; do
            if [ -f "$potential" ]; then
                found_json="$potential"
                break
            fi
        done

        if [ -z "$found_json" ]; then
            echo -e "${RED}Could not find rustdoc JSON for $crate${NC}"
            ls -la target/doc/*.json 2>/dev/null || echo "No JSON files found"
            return 1
        fi

        # Copy to fixtures
        cp "$found_json" "$json_file"
        echo -e "${GREEN}Saved rustdoc JSON to fixtures${NC}"
    fi

    # Run the converter
    echo -e "${YELLOW}Running rustdoc-to-fumadocs...${NC}"
    rm -rf "$output_dir"
    mkdir -p "$output_dir"

    cd "$TOOL_DIR"
    local result
    if npm run dev -- --input "$json_file" --output "$output_dir" --json 2>&1; then
        result=$(npm run dev -- --input "$json_file" --output "$output_dir" --json 2>&1)

        # Count generated files
        local mdx_count=$(find "$output_dir" -name "*.mdx" 2>/dev/null | wc -l | tr -d ' ')
        local json_count=$(find "$output_dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

        echo -e "${GREEN}✓ Success: Generated $mdx_count MDX files, $json_count meta.json files${NC}"

        # Show sample output
        echo ""
        echo "Sample generated files:"
        find "$output_dir" -type f | head -10 | while read -r f; do
            echo "  - ${f#$output_dir/}"
        done

        # Validate MDX structure (basic check)
        local invalid_mdx=0
        while IFS= read -r mdx_file; do
            if ! head -1 "$mdx_file" | grep -q "^---$"; then
                echo -e "${YELLOW}Warning: $mdx_file missing frontmatter${NC}"
                ((invalid_mdx++))
            fi
        done < <(find "$output_dir" -name "*.mdx")

        if [ "$invalid_mdx" -gt 0 ]; then
            echo -e "${YELLOW}$invalid_mdx files with potential issues${NC}"
        fi

        return 0
    else
        echo -e "${RED}✗ Failed to convert $crate${NC}"
        echo "$result"
        return 1
    fi
}

# Track results
passed=0
failed=0
skipped=0

# Test each crate
for crate in "${CRATES[@]}"; do
    if test_crate "$crate"; then
        ((passed++))
    else
        ((failed++))
    fi
done

# Summary
echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $passed${NC}"
echo -e "${RED}Failed: $failed${NC}"
echo ""

# Exit with appropriate code
if [ "$failed" -gt 0 ]; then
    exit 1
fi
exit 0
