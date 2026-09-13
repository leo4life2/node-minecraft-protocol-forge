package net.minecraft.commands.synchronization;
import com.mojang.brigadier.arguments.ArgumentType;
public class ArgumentTypeInfos {
  public static <A extends ArgumentType<?>, T extends ArgumentTypeInfo.Template<A>, I extends ArgumentTypeInfo<A, T>> I registerByClass(Class<A> cls, I info) { return info; }
}
