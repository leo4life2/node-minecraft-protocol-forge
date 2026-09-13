package fx.counter.alpha;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class A1 implements CustomPacketPayload {
  public static final StreamCodec<Object, A1> STREAM_CODEC = new StreamCodec<Object, A1>() {};
  public Type<A1> type() { throw new UnsupportedOperationException(); }
}
