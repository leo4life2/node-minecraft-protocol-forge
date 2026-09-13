package fx.counter.lib;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
/** the plain int-field counter variant: `"/" + next++` */
public final class IntCtx {
  private int next;
  private final Identifier channelName;
  private final PayloadRegistrar registrar;
  public IntCtx(String modId, RegisterPayloadHandlersEvent event) { this.channelName = Identifier.fromNamespaceAndPath(modId, "main"); this.registrar = event.registrar(this.channelName.toString()); }
  public <T extends CustomPacketPayload> void playToClient(Class<T> clazz, StreamCodec<?, T> codec) {
    CustomPacketPayload.Type<T> type = new CustomPacketPayload.Type<>(this.channelName.withSuffix("/" + this.next++));
    this.registrar.playToClient(type, codec, (payload, ctx) -> {});
  }
}
