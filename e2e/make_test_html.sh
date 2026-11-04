#!/bin/bash
# usage: e2e/make_test_html.sh Saturn-Rewards-Redesign_1.html /tmp/test.html
# Creates a TEST-ONLY copy of the frontend with Privy disabled (Privy cannot load in an offline test browser). Never deploy the copy.
sed "s/APP_ID:\x27cmv1ke5s6006p0fjruyd2obw5\x27/APP_ID:\x27\x27/" "$1" > "$2" && grep -c "APP_ID:\x27\x27" "$2"
