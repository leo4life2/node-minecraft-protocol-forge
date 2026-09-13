package fx.ver.zeta;
import fx.ver.epsilon.ClassHandler;
import fx.ver.lib.NeoNetworking; import fx.ver.lib.Network;
import net.minecraft.resources.Identifier;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
/** the class reference is a RUNTIME value (Class.forName) — the id cannot be proven, the deriver must abstain by name. */
@Mod("zeta")
public final class ZetaMod {
  static final Network CHANNEL = new Network(Identifier.fromNamespaceAndPath("zeta", "net"), 2);
  public ZetaMod(ModContainer container) throws Exception {
    container.getEventBus().addListener(NeoNetworking::setupNetwork);
    CHANNEL.register(new ClassHandler<>(Class.forName(System.getProperty("zeta.packet"))));
  }
}
