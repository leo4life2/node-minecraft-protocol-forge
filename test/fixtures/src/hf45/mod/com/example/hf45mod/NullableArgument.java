package com.example.hf45mod;
import com.mojang.brigadier.arguments.ArgumentType;
import net.minecraft.commands.synchronization.ArgumentTypeInfo;
import net.minecraft.network.FriendlyByteBuf;
public class NullableArgument implements ArgumentType<String> {
  public static class Info implements ArgumentTypeInfo<NullableArgument, Info.Template> {
    public void serializeToNetwork(Template t, FriendlyByteBuf buf) { buf.writeNullable(t.hint, (b, s) -> b.writeUtf(s)); }
    public final class Template implements ArgumentTypeInfo.Template<NullableArgument> { public String hint; }
  }
}
