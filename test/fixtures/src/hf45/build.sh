#!/bin/sh
# Rebuilds the HF45 javac fixture (real javac bytecode: a mod registering command argument types with
# a varint+utf serializer, a writeNullable serializer (non-derivable), a branching serializer (non-derivable)
# and a SingletonArgumentInfo one). usage: sh test/fixtures/src/hf45/build.sh (needs /usr/local/opt/openjdk/bin/{javac,jar})
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=$HERE/../../; JDK=/usr/local/opt/openjdk/bin
TMP=$(mktemp -d); mkdir -p $TMP/stubs $TMP/mod
$JDK/javac --release 21 -d $TMP/stubs $(find $HERE/stubs -name '*.java')
$JDK/javac --release 21 -cp $TMP/stubs -d $TMP/mod $(find $HERE/mod -name '*.java')
cp -R $HERE/mod/META-INF $TMP/mod/
rm -f $OUT/hf45-argument-types.jar
(cd $TMP/mod && $JDK/jar --create --file $OUT/hf45-argument-types.jar --no-manifest .)
rm -rf $TMP; ls -la $OUT/hf45-argument-types.jar
