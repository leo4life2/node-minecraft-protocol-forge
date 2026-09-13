package net.minecraft.resources;
public final class Identifier {
  private final String ns, path;
  private Identifier(String ns, String path) { this.ns = ns; this.path = path; }
  public static Identifier fromNamespaceAndPath(String ns, String path) { return new Identifier(ns, path); }
  public static Identifier parse(String s) { int i = s.indexOf(':'); return new Identifier(s.substring(0, i), s.substring(i + 1)); }
  public Identifier withSuffix(String s) { return new Identifier(ns, path + s); }
  public Identifier withPrefix(String s) { return new Identifier(ns, s + path); }
  public Identifier withPath(String p) { return new Identifier(ns, p); }
  public String getNamespace() { return ns; }
  public String getPath() { return path; }
  @Override public String toString() { return ns + ":" + path; }
}
