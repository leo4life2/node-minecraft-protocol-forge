package fx.counter.beta;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class B2 implements CustomPacketPayload {
  public static final StreamCodec<Object, B2> STREAM_CODEC = new StreamCodec<Object, B2>() {};
  public Type<B2> type() { throw new UnsupportedOperationException(); }
}
