package org.spongepowered.asm.mixin;
import java.lang.annotation.*;
@Retention(RetentionPolicy.CLASS) @Target(ElementType.TYPE) public @interface Mixin { Class<?>[] value() default {}; String[] targets() default {}; }
