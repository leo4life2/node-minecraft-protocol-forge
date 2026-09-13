package net.neoforged.neoforge.network.registration;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.neoforged.neoforge.network.handling.IPayloadHandler;
public class PayloadRegistrar {
  public PayloadRegistrar(String version) {}
  public PayloadRegistrar optional() { return this; }
  public PayloadRegistrar versioned(String v) { return this; }
  public <T extends CustomPacketPayload> PayloadRegistrar playToClient(CustomPacketPayload.Type<T> type, StreamCodec<?, T> codec, IPayloadHandler<T> handler) { return this; }
  public <T extends CustomPacketPayload> PayloadRegistrar playToServer(CustomPacketPayload.Type<T> type, StreamCodec<?, T> codec, IPayloadHandler<T> handler) { return this; }
  public <T extends CustomPacketPayload> PayloadRegistrar configurationToClient(CustomPacketPayload.Type<T> type, StreamCodec<?, T> codec, IPayloadHandler<T> handler) { return this; }
}
