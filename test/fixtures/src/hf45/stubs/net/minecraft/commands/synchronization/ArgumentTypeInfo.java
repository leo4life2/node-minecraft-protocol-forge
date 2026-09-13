package net.minecraft.commands.synchronization;
import com.mojang.brigadier.arguments.ArgumentType;
import net.minecraft.network.FriendlyByteBuf;
public interface ArgumentTypeInfo<A extends ArgumentType<?>, T extends ArgumentTypeInfo.Template<A>> {
  void serializeToNetwork(T template, FriendlyByteBuf buf);
  interface Template<A extends ArgumentType<?>> { }
}
