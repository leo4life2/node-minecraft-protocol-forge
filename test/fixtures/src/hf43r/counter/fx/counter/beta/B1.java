package fx.counter.beta;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class B1 implements CustomPacketPayload {
  public static final StreamCodec<Object, B1> STREAM_CODEC = new StreamCodec<Object, B1>() {};
  public Type<B1> type() { throw new UnsupportedOperationException(); }
}
