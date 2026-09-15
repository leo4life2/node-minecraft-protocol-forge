#!/bin/sh
# Rebuilds the HF49 javac fixture: the count-REPLACE mixin shapes the item-wire derivation must abstain on
# (two primitives in the write redirect, a read redirect that still reads, mismatched types, a non-count
# primitive, an unpaired write, a second-store variable pin). Real javac bytecode, RUNTIME injector annotations.
# usage: sh test/fixtures/src/hf49/build.sh   (needs /usr/local/opt/openjdk@17/bin/{javac,jar})
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=$HERE/../../; JDK=/usr/local/opt/openjdk@17/bin
TMP=$(mktemp -d); mkdir -p $TMP/stubs $TMP/shapes
$JDK/javac --release 17 -d $TMP/stubs $(find $HERE/stubs -name '*.java')
$JDK/javac --release 17 -cp $TMP/stubs -d $TMP/shapes $(find $HERE/shapes -name '*.java')
rm -f $OUT/hf49-count-replace-shapes.jar
(cd $TMP/shapes && $JDK/jar --create --file $OUT/hf49-count-replace-shapes.jar --no-manifest .)
rm -rf $TMP; ls -la $OUT/hf49-count-replace-shapes.jar
