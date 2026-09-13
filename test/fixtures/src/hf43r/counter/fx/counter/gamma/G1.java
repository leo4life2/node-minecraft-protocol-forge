package fx.counter.gamma;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class G1 implements CustomPacketPayload {
  public static final StreamCodec<Object, G1> STREAM_CODEC = new StreamCodec<Object, G1>() {};
  public Type<G1> type() { throw new UnsupportedOperationException(); }
}
