package net.minecraft.network;
public class FriendlyByteBuf {
  public FriendlyByteBuf writeUtf(String s) { return this; }
  public FriendlyByteBuf writeVarInt(int v) { return this; }
  public FriendlyByteBuf writeInt(int v) { return this; }
  public FriendlyByteBuf writeBoolean(boolean v) { return this; }
  public <T> void writeNullable(T v, java.util.function.BiConsumer<FriendlyByteBuf, T> w) { }
}
