package fx.ver.lib;
public interface Networking { void register(ClientboundPacketType<?> type); void register(ServerboundPacketType<?> type); }
