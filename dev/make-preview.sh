#!/bin/sh
# Builds a test copy of the site into ./next/ (served at /budget/next/ once on main).
# It keeps its browser data under its own prefix, so it never touches the real site's settings.
set -e
cd "$(dirname "$0")/.."
rm -rf next && mkdir -p next
cp -r index.html css js next/
sed -i "s/STORAGE_PREFIX = 'budget'/STORAGE_PREFIX = 'budget-next'/" next/js/config.js
grep -q "STORAGE_PREFIX = 'budget-next'" next/js/config.js
sed -i 's|<title>Οικογενειακά έξοδα</title>|<title>Δοκιμή: Οικογενειακά έξοδα</title>|; s|<div class="brand">Οικογενειακά έξοδα<small|<div class="brand">Έξοδα (δοκιμή)<small|' next/index.html
grep -q 'Έξοδα (δοκιμή)' next/index.html
echo "next/ ready"
