package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 1: the write redirect writes TWO primitives in place of the byte -> abstain replace-multi-primitive
@Mixin(FriendlyByteBuf.class) public abstract class TwoPrimWrite {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeByte(I)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf twoPrims(FriendlyByteBuf buf, int count) { buf.writeShort(count >> 16); return buf.writeInt(count); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readByte()B"))
  private byte skip(FriendlyByteBuf buf) { return 0; }
  @ModifyVariable(method = "readItem", at = @At("STORE"), ordinal = 0)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readInt(); }
}
