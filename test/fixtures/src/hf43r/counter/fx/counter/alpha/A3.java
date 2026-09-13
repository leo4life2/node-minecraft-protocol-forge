package fx.counter.alpha;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class A3 implements CustomPacketPayload {
  public static final StreamCodec<Object, A3> STREAM_CODEC = new StreamCodec<Object, A3>() {};
  public Type<A3> type() { throw new UnsupportedOperationException(); }
}
