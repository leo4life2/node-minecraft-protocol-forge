package fx.ver.delta;
import fx.ver.lib.ServerboundPacketType;
import net.minecraft.resources.Identifier;
public final class AnimPacket {
  public static final Identifier ID = Delta.makeID("anim_packet");
  public static final ServerboundPacketType<AnimPacket> TYPE = new Handler();
  private static final class Handler implements ServerboundPacketType<AnimPacket> { public Identifier id() { return ID; } }
}
