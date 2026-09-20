package syn2; import net.minecraft.world.level.block.Block; import net.minecraft.world.level.block.state.BlockBehaviour; import net.minecraftforge.registries.*; public class Reg { public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, "synmod2"); static {
 BLOCKS.register("helper_str", () -> new HelperStrBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("helper_ii", () -> new HelperIIBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("helper_cls", () -> new HelperClsBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("subset", () -> new SubsetBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("pred", () -> new PredBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("nosuper_slab", () -> new NoSuperSlab(BlockBehaviour.Properties.of()));
 BLOCKS.register("withsuper_slab", () -> new WithSuperSlab(BlockBehaviour.Properties.of()));
 BLOCKS.register("chk", () -> new ChkBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("constbound", () -> new ConstBoundBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("dynbound", () -> new DynBoundBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("alias", () -> new AliasBlock(BlockBehaviour.Properties.of()));
 BLOCKS.register("named_via_call", () -> new NamedViaCallBlock(BlockBehaviour.Properties.of()));
} }
