package com.example.hf45mod;
import com.mojang.brigadier.arguments.ArgumentType;
import net.minecraft.commands.synchronization.ArgumentTypeInfo;
import net.minecraft.network.FriendlyByteBuf;
public class VarintArgument implements ArgumentType<Integer> {
  public final int max; public final String label;
  public VarintArgument(int max, String label) { this.max = max; this.label = label; }
  public static class Info implements ArgumentTypeInfo<VarintArgument, Info.Template> {
    public void serializeToNetwork(Template t, FriendlyByteBuf buf) { buf.writeVarInt(t.max); buf.writeUtf(t.label); }
    public final class Template implements ArgumentTypeInfo.Template<VarintArgument> { public int max; public String label; }
  }
}
