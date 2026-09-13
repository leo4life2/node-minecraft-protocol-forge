package fx.ver.lib;
import net.minecraft.resources.Identifier;
/** version-prefixed ids: the channel is "<ns>:<path>/v<N>", the registrar version "v<N>", each packet id appended (resourceful-lib shape). */
public class Network implements Networking {
  private static final NetworkService SERVICE = NetworkService.create();
  private final Networking networking;
  private final boolean optional;
  public Network(Identifier id, int version) { this(id, version, false); }
  public Network(Identifier id, int version, boolean optional) { this.networking = SERVICE.getNetwork(id, version, optional); this.optional = optional; }
  public final void register(ClientboundPacketType<?> type) { this.networking.register(type); }
  public final void register(ServerboundPacketType<?> type) { this.networking.register(type); }
}
