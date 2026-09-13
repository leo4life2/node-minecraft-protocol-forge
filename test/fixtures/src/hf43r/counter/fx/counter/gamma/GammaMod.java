package fx.counter.gamma;
import fx.counter.lib.SharedCtx;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
@Mod("gamma")
public final class GammaMod {
  static final SharedCtx CTX = new SharedCtx("gamma");
  public GammaMod(ModContainer container) {
    container.getEventBus().addListener((RegisterPayloadHandlersEvent e) -> CTX.bind(e).playToClient(G1.class, G1.STREAM_CODEC));
    container.getEventBus().addListener((RegisterPayloadHandlersEvent e) -> CTX.bind(e).playToClient(G2.class, G2.STREAM_CODEC));
  }
}
