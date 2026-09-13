package fx.counter.lib;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
/** one static counter shared by two independent event listeners: the registration order across listeners is not provable. */
public final class SharedCtx {
  private final AtomicInteger counter = new AtomicInteger();
  private final Identifier channelName;
  public SharedCtx(String modId) { this.channelName = Identifier.fromNamespaceAndPath(modId, "main"); }
  public Bound bind(RegisterPayloadHandlersEvent event) { return new Bound(event.registrar(this.channelName.toString())); }
  public final class Bound {
    private final PayloadRegistrar registrar;
    Bound(PayloadRegistrar r) { this.registrar = r; }
    public <T extends CustomPacketPayload> void playToClient(Class<T> clazz, StreamCodec<?, T> codec) {
      CustomPacketPayload.Type<T> type = new CustomPacketPayload.Type<>(channelName.withSuffix("/" + counter.getAndIncrement()));
      this.registrar.playToClient(type, codec, (payload, ctx) -> {});
    }
  }
}
