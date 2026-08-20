{
  description = "UN RP map site dev environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          python3
          python3Packages.pillow
          python3Packages.pyproj
          python3Packages.numpy
          python3Packages.scipy
          python3Packages.shapely
          python3Packages.rasterio
          python3Packages.pyshp
          python3Packages.svgpathtools
          imagemagick
          curl
          unzip
          jq
          nodejs
        ];

        shellHook = ''
          echo "UN RP map dev shell ready"
        '';
      };
    };
}
