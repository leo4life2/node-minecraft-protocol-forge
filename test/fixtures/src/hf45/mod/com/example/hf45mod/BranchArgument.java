package com.example.hf45mod;
import com.mojang.brigadier.arguments.ArgumentType;
import net.minecraft.commands.synchronization.ArgumentTypeInfo;
import net.minecraft.network.FriendlyByteBuf;
public class BranchArgument implements ArgumentType<String> {
  public static class Info implements ArgumentTypeInfo<BranchArgument, Info.Template> {
    public void serializeToNetwork(Template t, FriendlyByteBuf buf) { buf.writeBoolean(t.wide); if (t.wide) buf.writeInt(t.width); }
    public final class Template implements ArgumentTypeInfo.Template<BranchArgument> { public boolean wide; public int width; }
  }
}
