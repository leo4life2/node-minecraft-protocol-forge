package fx.counter.alpha;
import fx.counter.lib.ModInit; import fx.counter.lib.ServerCtx;
public final class Alpha implements ModInit {
  public void onRegisterPayloadTypes(ServerCtx ctx) {
    ctx.playToClient(A1.class, A1.STREAM_CODEC);
    ctx.playToClient(A2.class, A2.STREAM_CODEC);
    ctx.playToServer(A3.class, A3.STREAM_CODEC);
  }
}
