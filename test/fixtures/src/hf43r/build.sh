#!/bin/sh
# Rebuilds the HF43-r javac fixtures (real javac bytecode: invokedynamic string concat, lambdas, method refs, services).
# usage: sh test/fixtures/src/hf43r/build.sh   (needs /usr/local/opt/openjdk/bin/{javac,jar})
set -e
HERE=$(cd "$(dirname "$0")" && pwd); OUT=$HERE/../../; JDK=/usr/local/opt/openjdk/bin
TMP=$(mktemp -d); mkdir -p $TMP/stubs $TMP/counter $TMP/versioned
$JDK/javac --release 21 -d $TMP/stubs $(find $HERE/stubs -name '*.java')
$JDK/javac --release 21 -cp $TMP/stubs -d $TMP/counter $(find $HERE/counter -name '*.java')
$JDK/javac --release 21 -cp $TMP/stubs -d $TMP/versioned $(find $HERE/versioned -name '*.java')
cp -R $HERE/counter/META-INF $TMP/counter/; cp -R $HERE/versioned/META-INF $TMP/versioned/
rm -f $OUT/hf43r-counter-ids.jar $OUT/hf43r-versioned-ids.jar
(cd $TMP/counter && $JDK/jar --create --file $OUT/hf43r-counter-ids.jar --no-manifest .)
(cd $TMP/versioned && $JDK/jar --create --file $OUT/hf43r-versioned-ids.jar --no-manifest .)
rm -rf $TMP; ls -la $OUT/hf43r-*.jar
