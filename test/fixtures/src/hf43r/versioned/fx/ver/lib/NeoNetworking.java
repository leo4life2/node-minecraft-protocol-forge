package fx.ver.lib;
import java.util.ArrayList; import java.util.Collections; import java.util.List; import java.util.function.Consumer;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
public class NeoNetworking implements Networking {
  private static final List<Consumer<RegisterPayloadHandlersEvent>> LISTENERS = Collections.synchronizedList(new ArrayList<>());
  private final List<ClientboundPacketType<?>> clientPackets = new ArrayList<>();
  private final List<ServerboundPacketType<?>> serverPackets = new ArrayList<>();
  private final Identifier channel;
  private final String version;
  private final boolean optional;
  public NeoNetworking(Identifier id, int version, boolean optional) {
    this.channel = id.withSuffix("/v" + version);
    this.version = "v" + version;
    this.optional = optional;
    LISTENERS.add(this::onNetworkSetup);
  }
  public void register(ClientboundPacketType<?> type) { this.clientPackets.add(type); }
  public void register(ServerboundPacketType<?> type) { this.serverPackets.add(type); }
  public void onNetworkSetup(RegisterPayloadHandlersEvent event) {
    PayloadRegistrar registrar = event.registrar(this.version);
    if (this.optional) registrar = registrar.optional();
    for (ClientboundPacketType<?> type : this.clientPackets) registerClientbound(registrar, type);
    for (ServerboundPacketType<?> type : this.serverPackets) registerServerbound(registrar, type);
  }
  private void registerClientbound(PayloadRegistrar registrar, ClientboundPacketType<?> type) { registrar.playToClient(type.type(this.channel), null, (p, c) -> {}); }
  private void registerServerbound(PayloadRegistrar registrar, ServerboundPacketType<?> type) { registrar.playToServer(type.type(this.channel), null, (p, c) -> {}); }
  public static void setupNetwork(RegisterPayloadHandlersEvent event) { LISTENERS.forEach(listener -> listener.accept(event)); }
}
