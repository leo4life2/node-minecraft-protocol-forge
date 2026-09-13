package fx.counter.beta;
import fx.counter.lib.IntCtx;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
@Mod("beta")
public final class BetaMod {
  public BetaMod(ModContainer container) { container.getEventBus().addListener(this::onRegister); }
  private void onRegister(RegisterPayloadHandlersEvent event) {
    IntCtx ctx = new IntCtx("beta", event);
    ctx.playToClient(B1.class, B1.STREAM_CODEC);
    ctx.playToClient(B2.class, B2.STREAM_CODEC);
  }
}
