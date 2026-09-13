package fx.ver.delta;
import fx.ver.lib.ClientboundPacketType;
import net.minecraft.resources.Identifier;
public final class SyncPacket {
  public static final Identifier ID = Delta.makeID("sync_packet");
  public static final ClientboundPacketType<SyncPacket> TYPE = new Handler();
  private static final class Handler implements ClientboundPacketType<SyncPacket> { public Identifier id() { return ID; } }
}
