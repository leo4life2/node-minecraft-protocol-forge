package net.minecraft.commands.synchronization;
import com.mojang.brigadier.arguments.ArgumentType;
import java.util.function.Supplier;
public class SingletonArgumentInfo<A extends ArgumentType<?>> implements ArgumentTypeInfo<A, SingletonArgumentInfo<A>.Template> {
  public static <T extends ArgumentType<?>> SingletonArgumentInfo<T> contextFree(Supplier<T> s) { return new SingletonArgumentInfo<T>(); }
  public void serializeToNetwork(Template t, net.minecraft.network.FriendlyByteBuf buf) { }
  public final class Template implements ArgumentTypeInfo.Template<A> { }
}
