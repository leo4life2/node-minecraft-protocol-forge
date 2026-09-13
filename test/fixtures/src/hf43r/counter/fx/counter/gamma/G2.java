package fx.counter.gamma;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
public final class G2 implements CustomPacketPayload {
  public static final StreamCodec<Object, G2> STREAM_CODEC = new StreamCodec<Object, G2>() {};
  public Type<G2> type() { throw new UnsupportedOperationException(); }
}
