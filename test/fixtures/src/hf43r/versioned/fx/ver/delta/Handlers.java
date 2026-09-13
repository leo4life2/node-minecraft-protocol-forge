package fx.ver.delta;
import fx.ver.lib.Network;
public final class Handlers {
  public static final Network DEFAULT_CHANNEL = new Network(Delta.makeID("networking"), 1);
  public static void init() { DEFAULT_CHANNEL.register(SyncPacket.TYPE); DEFAULT_CHANNEL.register(AnimPacket.TYPE); }
}
