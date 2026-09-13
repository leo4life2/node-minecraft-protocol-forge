package fx.counter.lib;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
public class ServerCtx extends PayloadTypesCtx {
  private final PayloadRegistrar registrar;
  public ServerCtx(String modId, RegisterPayloadHandlersEvent event) { super(modId); this.registrar = event.registrar(this.channelName.toString()); }
  public <T extends CustomPacketPayload> void playToClient(Class<T> clazz, StreamCodec<?, T> codec) {
    CustomPacketPayload.Type<T> type = this.registerPayloadType(clazz);
    this.registrar.playToClient(type, codec, (payload, ctx) -> {});
  }
  public <T extends CustomPacketPayload> void playToServer(Class<T> clazz, StreamCodec<?, T> codec) {
    CustomPacketPayload.Type<T> type = this.registerPayloadType(clazz);
    this.registrar.playToServer(type, codec, (payload, ctx) -> {});
  }
}
