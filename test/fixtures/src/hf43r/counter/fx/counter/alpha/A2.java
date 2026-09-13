package fx.counter.alpha;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class A2 implements CustomPacketPayload {
  public static final StreamCodec<Object, A2> STREAM_CODEC = new StreamCodec<Object, A2>() {};
  public Type<A2> type() { throw new UnsupportedOperationException(); }
}
