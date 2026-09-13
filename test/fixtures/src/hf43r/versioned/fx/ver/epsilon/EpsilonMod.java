package fx.ver.epsilon;
import fx.ver.lib.NeoNetworking; import fx.ver.lib.Network;
import net.minecraft.resources.Identifier;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
@Mod("epsilon")
public final class EpsilonMod {
  static final Network CHANNEL = new Network(Identifier.fromNamespaceAndPath("epsilon", "net"), 3);
  public EpsilonMod(ModContainer container) {
    container.getEventBus().addListener(NeoNetworking::setupNetwork);
    CHANNEL.register(new ClassHandler<>(EPacket.class));
  }
}
