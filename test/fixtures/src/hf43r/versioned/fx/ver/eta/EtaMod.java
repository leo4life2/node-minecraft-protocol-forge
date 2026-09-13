package fx.ver.eta;
import fx.ver.epsilon.ClassHandler;
import fx.ver.lib.NeoNetworking; import fx.ver.lib.Network;
import net.minecraft.resources.Identifier;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
/** the network is built in COMMON SETUP (enqueueWork), which the loader runs before the payload event */
@Mod("eta")
public final class EtaMod {
  private static Network channel;
  public EtaMod(ModContainer container) {
    container.getEventBus().addListener(NeoNetworking::setupNetwork);
    container.getEventBus().addListener(this::onSetup);
  }
  private void onSetup(FMLCommonSetupEvent event) {
    event.enqueueWork(() -> {
      channel = new Network(Identifier.fromNamespaceAndPath("eta", "net"), 2);
      channel.register(new ClassHandler<>(EtaPacket.class));
    });
  }
}
