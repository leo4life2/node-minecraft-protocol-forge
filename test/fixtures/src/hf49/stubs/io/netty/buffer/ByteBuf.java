package io.netty.buffer;
public abstract class ByteBuf {
  public abstract ByteBuf writeByte(int v); public abstract ByteBuf writeShort(int v); public abstract ByteBuf writeInt(int v); public abstract ByteBuf writeBoolean(boolean v);
  public abstract byte readByte(); public abstract short readShort(); public abstract int readInt(); public abstract boolean readBoolean();
}
