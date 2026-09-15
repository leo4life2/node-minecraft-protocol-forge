package fx.hf49;
import io.netty.buffer.ByteBuf; import net.minecraft.network.FriendlyByteBuf;
import org.spongepowered.asm.mixin.Mixin; import org.spongepowered.asm.mixin.injection.*;
// bend 4: the redirected primitive is the 'present' boolean, not a count -> abstain replace-non-count-target
@Mixin(FriendlyByteBuf.class) public abstract class NonCountTarget {
  @Redirect(method = "writeItemStack", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;writeBoolean(Z)Lio/netty/buffer/ByteBuf;"))
  private ByteBuf wide(FriendlyByteBuf buf, boolean present) { return buf.writeInt(present ? 1 : 0); }
  @Redirect(method = "readItem", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/FriendlyByteBuf;readBoolean()Z"))
  private boolean skip(FriendlyByteBuf buf) { return true; }
  @ModifyVariable(method = "readItem", at = @At("STORE"), ordinal = 0)
  private int count(int v) { return ((FriendlyByteBuf) (Object) this).readInt(); }
}
